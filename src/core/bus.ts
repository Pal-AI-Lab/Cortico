/**
 * WakeBus 按到达顺序向单个消费者交付整个队列。触发模式及默认值见 types.ts 的 TriggerMode。
 * debounce 的投递时间为 min(首件 + maxBatchAge, max(首件 + minBatchAge, 末件 + quietGap))；
 * 可计数外部事件达到 maxBatchSize 时立即投递。
 * 队列包含即时事件、延迟渲染项与候选项。延迟渲染项不参与关键词匹配或外部事件计数；
 * 候选项按外部事件计数，关键词只检查 gateText。
 * piggyback 不触发计时、关键词或溢出，也不单独获得投递许可；需要其他项触发投递。
 * preempt 与 interrupt 投递后通知主循环；取消哪一部分由主循环裁决。
 * 人工暂停阻止所有投递。DeliveryGate 解除、关键词回调授权或溢出授权均放行整批。
 */
import type { DeliveryGate, EventOrigin, Logger, TriggerMode, WakeItem } from './types.ts';
import { nullLogger } from './util.ts';

export interface WakeBusOptions {
  /** 末件到达之后安静这么久才投递 */
  quietGapMs: number;
  /** 首件到达起至少攒这么久 */
  minBatchAgeMs: number;
  /** 首件到达起最多攒这么久,到点强制投递 */
  maxBatchAgeMs: number;
  /** 积压事件达到这个条数就强制投递 */
  maxBatchSize: number;
}

// 每次 push 读取同一个配置对象，原位修改在下一次 push 生效。

/** 入队时固定 piggyback 标志，后续计数与调度沿用该值。 */
interface Queued {
  item: WakeItem;
  piggyback: boolean;
}

export class WakeBus {
  private opts: WakeBusOptions;
  private queue: Queued[] = [];
  private paused = false;
  private gate: DeliveryGate | null = null;
  /** 一次整批投递许可;人工暂停的优先级更高。 */
  private bypassGateOnce = false;
  /** 到期即投递的那一个定时器;每次 push 按四条判据重算 */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 本批首件与末件的到达时刻(队列空时为 null) */
  private firstAt: number | null = null;
  private lastAt = 0;
  /** 挂起中的消费者(单消费者,最多一个) */
  private waiter: ((batch: WakeItem[]) => void) | null = null;
  /** 已到投递条件但没有消费者在等:置真,消费者一来就取走 */
  private ready = false;
  /** preempt 与 interrupt 只报告机械时机；取消范围由主循环裁决。 */
  private preemptHandler: ((trigger: 'preempt' | 'interrupt') => void) | null = null;

  private readonly log: Logger;

  constructor(opts: WakeBusOptions, log: Logger = nullLogger()) {
    this.opts = opts;
    this.log = log;
  }

  setPreemptHandler(handler: (trigger: 'preempt' | 'interrupt') => void): void {
    this.preemptHandler = handler;
  }

  push(item: WakeItem, opts?: { trigger?: TriggerMode }): void {
    const origin = originOf(item);
    const trigger: TriggerMode =
      opts?.trigger ?? (origin === 'internal' ? 'flush' : 'debounce');
    const piggyback = trigger === 'piggyback';
    this.queue.push({ item, piggyback });
    const gate = this.gate;
    if (gate) {
      this.clearTimers();
      // piggyback 不参与关键词或溢出判定。
      if (piggyback) return;
      // 延迟渲染项没有可用于关键词匹配的正文。
      const gateText = textForGate(item);
      if (origin === 'external' && gate.keyword !== undefined && gateText?.includes(gate.keyword)) {
        gate.onKeyword();
        const permitted = this.gate !== gate || this.bypassGateOnce;
        this.log.emit('debug', '闸门关键词命中', { event: 'gate-keyword', data: { gate: gate.id, permitted } });
        if (permitted) this.deliver(this.bypassGateOnce);
        this.notifyPreempt(trigger, permitted);
        return;
      }
      // 已经有一批获准放行时,新到直接并入该批,不重复产生溢出通知。
      if (this.bypassGateOnce) {
        this.deliver(true);
        this.notifyPreempt(trigger, true);
        return;
      }
      if (origin === 'external' && this.pendingEventCount() > gate.overflowLimit) {
        // 回调可能同步注入事件；先设置许可，使注入项仍属于当前批。
        this.bypassGateOnce = true;
        this.log.emit('debug', '闸门下积压越过溢出线,整批放行', { event: 'gate-overflow', data: { gate: gate.id, pending: this.pendingEventCount(), limit: gate.overflowLimit } });
        gate.onOverflow();
        this.deliver(true);
        this.notifyPreempt(trigger, true);
      }
      return;
    }

    if (trigger === 'preempt' || trigger === 'interrupt') {
      const permitted = !this.blocked();
      this.deliver();
      this.notifyPreempt(trigger, permitted);
      return;
    }
    if (trigger === 'flush') {
      this.deliver();
      return;
    }
    // piggyback 不启动或延后批次计时器。
    if (piggyback) return;
    const now = Date.now();
    if (this.firstAt === null) this.firstAt = now;
    this.lastAt = now;
    if (this.pendingEventCount() >= this.opts.maxBatchSize) {
      this.deliver();
      return;
    }
    this.arm();
  }

  /** 重新计算投递时间；配置修改在下一次 push 生效。 */
  private arm(): void {
    if (this.firstAt === null) return;
    const { quietGapMs, minBatchAgeMs, maxBatchAgeMs } = this.opts;
    const at = Math.min(
      this.firstAt + maxBatchAgeMs,
      Math.max(this.firstAt + minBatchAgeMs, this.lastAt + quietGapMs),
    );
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.deliver(), Math.max(0, at - Date.now()));
  }

  /** 暂停或闸门(未获准整批放行)期间不投递。 */
  private blocked(): boolean {
    return this.paused || (this.gate !== null && !this.bypassGateOnce);
  }

  /** 已获准投递的 preempt 与 interrupt 才通知主循环；暂停与闸门继续拥有更高优先级。 */
  private notifyPreempt(trigger: TriggerMode, permitted: boolean): void {
    if ((trigger === 'preempt' || trigger === 'interrupt') && permitted && !this.paused) {
      this.log.emit('debug', trigger === 'preempt' ? '抢占:请求取消尚未外化的在途模型轮' : '打断:请求停止当前轮', { event: trigger });
      this.preemptHandler?.(trigger);
    }
  }

  /**
   * 把首个匹配的排队项改为按 trigger 立即投递；piggyback 项随之可单独触发投递。
   * 暂停或闸门未放行时只改标志，放行时随整批投递，不再通知主循环。没有匹配项时返回 false。
   */
  promote(pred: (item: WakeItem) => boolean, trigger: 'flush' | 'preempt' | 'interrupt'): boolean {
    const queued = this.queue.find((q) => pred(q.item));
    if (!queued) return false;
    queued.piggyback = false;
    if (this.gate !== null && !this.bypassGateOnce) return true;
    const permitted = !this.blocked();
    this.deliver(this.bypassGateOnce);
    this.notifyPreempt(trigger, permitted);
    return true;
  }

  /** 人工暂停/继续(控制台);继续时积压一次性投递 */
  setPaused(v: boolean): void {
    if (v !== this.paused) this.log.emit('info', v ? '总线已暂停:事件照常落库,不投递' : '总线继续', { event: v ? 'paused' : 'resumed', data: { queued: this.queue.length } });
    this.paused = v;
    if (!this.paused && (this.ready || this.queue.length > 0)) {
      this.deliver(this.bypassGateOnce);
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * 安装或更新投递闸门。若此前没有闸门,安装前已经积压的内容获准放行一次;
   * 闸门只约束安装之后到达的唤醒项。
   */
  setDeliveryGate(gate: DeliveryGate): void {
    const hadGate = this.gate !== null;
    this.gate = gate;
    this.clearTimers();
    this.log.emit('debug', hadGate ? '投递闸门已更新' : '投递闸门已安装', { event: 'gate-set', data: { gate: gate.id, queued: this.queue.length } });
    if (!hadGate && this.queue.length > 0) {
      this.deliver(true);
    }
  }

  /**
   * 只解除匹配id的闸门。deliverQueued=false用于"先解闸、再把到期通知和积压
   * 一起投递",避免拆成两个user回合。
   */
  clearDeliveryGate(id: string, deliverQueued = true): boolean {
    if (this.gate?.id !== id) return false;
    this.gate = null;
    this.log.emit('debug', '投递闸门已解除', { event: 'gate-cleared', data: { gate: id, queued: this.queue.length, deliverQueued } });
    if (deliverQueued && this.queue.length > 0) {
      this.deliver(this.bypassGateOnce);
    }
    return true;
  }

  isDeliveryBlocked(): boolean {
    return this.gate !== null;
  }

  /** 当前积压条数(控制台可见性;含尚未成文的投递成文项) */
  pending(): number {
    return this.queue.length;
  }

  /** 供空闲判定使用：不计延迟渲染项和 piggyback 项。 */
  pendingImmediate(): number {
    let n = 0;
    for (const q of this.queue) {
      if (!q.piggyback && (q.item.event !== undefined || q.item.candidate !== undefined)) n++;
    }
    return n;
  }

  /** 按原序取出匹配项，消费后不再投递。同步完成，不触发消费者或改变投递许可和计时器。 */
  drainPending(pred: (item: WakeItem) => boolean): WakeItem[] {
    const drained: WakeItem[] = [];
    const kept: Queued[] = [];
    for (const q of this.queue) {
      if (pred(q.item)) drained.push(q.item);
      else kept.push(q);
    }
    this.queue = kept;
    // 仅剩 piggyback 项时清除 ready 和计时器，避免触发空批次。
    if (!this.hasWakingItem()) {
      this.ready = false;
      this.bypassGateOnce = false;
      this.firstAt = null;
      this.clearTimers();
    }
    return drained;
  }

  /**
   * 仅在满足投递条件时同步取走整批，否则返回 null。
   * 供工具调用链在没有 nextBatch 消费者时接收已就绪的通知。
   */
  takeIfReady(): WakeItem[] | null {
    if (!this.ready || this.queue.length === 0 || this.blocked()) return null;
    this.ready = false;
    return this.take();
  }

  /** 取走整个队列；尚不可投递时等待。只允许一个等待中的消费者。 */
  nextBatch(): Promise<WakeItem[]> {
    if (this.waiter) throw new Error('WakeBus只支持单消费者');
    if (this.ready && this.queue.length > 0 && !this.blocked()) {
      this.ready = false;
      return Promise.resolve(this.take());
    }
    return new Promise<WakeItem[]>((resolve) => {
      this.waiter = resolve;
    });
  }

  private deliver(bypassGate = false): void {
    this.clearTimers();
    // piggyback 需要其他项触发投递。
    if (this.queue.length > 0 && !this.hasWakingItem()) return;
    if (bypassGate) this.bypassGateOnce = true;
    if (this.blocked()) {
      this.ready = true;
      return;
    }
    if (this.queue.length === 0) {
      // 许可仅用于当前批，不能沿用到下一批。
      this.bypassGateOnce = false;
      return;
    }
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      this.ready = false;
      w(this.take());
    } else {
      this.ready = true;
    }
  }

  private take(): WakeItem[] {
    const batch = this.queue.map((q) => q.item);
    this.log.emit('debug', '投递一批', { event: 'deliver', data: { count: batch.length, piggyback: this.queue.filter((q) => q.piggyback).length, ageMs: this.firstAt === null ? 0 : Date.now() - this.firstAt } });
    this.queue = [];
    this.bypassGateOnce = false;
    this.firstAt = null; // 下一批的延迟下限和上限从首条事件重新计时。
    return batch;
  }

  /** 供批次大小与闸门上限使用：只计外部即时事件和候选项，不计 piggyback。 */
  private pendingEventCount(): number {
    let count = 0;
    for (const q of this.queue) {
      if (
        !q.piggyback &&
        (q.item.event !== undefined || q.item.candidate !== undefined) &&
        originOf(q.item) === 'external'
      ) count++;
    }
    return count;
  }

  private hasWakingItem(): boolean {
    return this.queue.some((q) => !q.piggyback);
  }

  private clearTimers(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function originOf(item: WakeItem): EventOrigin {
  return item.event?.origin ?? item.deferred?.origin ?? item.candidate!.origin;
}

function textForGate(item: WakeItem): string | null {
  return item.event?.text ?? item.candidate?.gateText ?? null;
}
