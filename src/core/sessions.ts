import type { ContextRecord } from '../protocol/open-responses/context.ts';
import type { ProviderAttempt } from './generation.ts';
import { usageCounters } from '../protocol/open-responses/context-helpers.ts';
/**
 * 控制台使用的 session 统计与消息引用，注册表仅驻留内存。
 * role 使用 Persona 声明的 session id；open 返回的实例 id 也传给模型调用。
 * 消息通过保存的引用在读取时序列化；重启清空统计。
 */
import type { LLMUsage, UsageRecord } from './types.ts';
import { nowIso } from './util.ts';

export interface SessionStats {
  id: string;
  /** session声明id(Persona定义的不透明字符串) */
  role: string;
  label: string;
  startedAt: string;
  /** null=进行中 */
  endedAt: string | null;
  /** LLM调用次数 */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  /** 缓存命中率估算 = hit/(hit+miss);无输入数据为null */
  cacheHitRate: number | null;
  /** 当前消息条数(引用实时读) */
  messageCount: number;
}

export interface SessionHandle {
  recordAttempts(attempts: readonly ProviderAttempt[], messagesRef?: ContextRecord[], extra?: { prefixHash?: string; outcome?: 'discarded' }): void;
  /** 本次 session 实例的 id；常驻 session 使用声明 id，临时 fork 使用运行期序号。 */
  id: string;
  /** 累计用量，可更新消息数组引用。model 用于持久化归因；extra 提供前缀指纹和费用记录。 */
  record(
    usage: LLMUsage,
    messagesRef?: ContextRecord[],
    model?: string,
    extra?: { prefixHash?: string; charges?: import('./generation.ts').Charge[] },
  ): void;
  /** 关闭 session；重复调用无效。 */
  close(): void;
}

interface Entry {
  stats: Omit<SessionStats, 'cacheHitRate' | 'messageCount'>;
  messagesRef: (() => readonly ContextRecord[]) | null;
  /** 用固定id注册的常驻session:结束后也不从仪表里清掉 */
  pinned: boolean;
}

/** 已结束session最多保留条数(临时session的近期历史,防内存膨胀) */
const CLOSED_KEEP = 8;

export class SessionTracker {
  private readonly timezone: string;
  private readonly onRecord?: (rec: UsageRecord) => void;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners: Array<() => void> = [];
  private seq = 0;

  /** onRecord=每次record时把一条持久化流水交出去(UsageLog.append),可选 */
  constructor(timezone: string, onRecord?: (rec: UsageRecord) => void) {
    this.timezone = timezone;
    this.onRecord = onRecord;
  }

  /** 变化通知(open/record/close都触发;web侧接这里做推送) */
  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  /**
   * 注册一个session。opts.id指定固定id(常驻session用它的声明id);
   * opts.messagesRef=消息数组的惰性引用(查看消息流/条数用)。
   */
  open(
    role: string,
    label: string,
    opts?: { id?: string; messagesRef?: () => readonly ContextRecord[] },
  ): SessionHandle {
    const id = opts?.id ?? `${role}-${++this.seq}`;
    const entry: Entry = {
      stats: {
        id,
        role,
        label,
        startedAt: nowIso(this.timezone),
        endedAt: null,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        reasoningTokens: 0,
      },
      messagesRef: opts?.messagesRef ?? null,
      pinned: opts?.id !== undefined,
    };
    this.entries.set(id, entry);
    this.pruneClosed();
    this.emit();

    let closed = false;
    return {
      id,
      recordAttempts: (attempts, messagesRef, extra) => {
        if (messagesRef) entry.messagesRef = () => messagesRef;
        for (const source of attempts) {
          const attempt = structuredClone(source);
          if (extra?.outcome === 'discarded' && (attempt.outcome === 'completed' || attempt.outcome === 'incomplete')) attempt.outcome = 'discarded';
          const usage = usageCounters(attempt.meters);
          const stats = entry.stats;
          stats.calls++;
          stats.promptTokens += usage.promptTokens;
          stats.completionTokens += usage.completionTokens;
          stats.cacheHitTokens += usage.cacheHitTokens;
          stats.cacheMissTokens += usage.cacheMissTokens;
          stats.reasoningTokens += usage.reasoningTokens ?? 0;
          this.onRecord?.({ version: 2, attempt, ts: nowIso(this.timezone, new Date(attempt.startedAt)), sessionId: id,
            role: stats.role, label: stats.label, model: attempt.origin.model, ...usage, reasoningTokens: usage.reasoningTokens ?? 0,
            failedAfterMs: attempt.elapsedMs, ...(attempt.requestId ? { requestId: attempt.requestId } : {}),
            ...(attempt.status !== null ? { status: attempt.status } : {}),
            ...(attempt.outcome === 'completed' || attempt.outcome === 'incomplete' ? {} : { outcome: attempt.outcome === 'discarded' ? 'discarded' : 'failed' }),
            ...(extra?.prefixHash ? { prefixHash: extra.prefixHash } : {}),
          });
        }
        this.emit();
      },
      record: (
        usage: LLMUsage,
        messagesRef?: ContextRecord[],
        model?: string,
        extra?: { prefixHash?: string; charges?: import('./generation.ts').Charge[] },
      ) => {
        if (closed) return;
        const s = entry.stats;
        s.calls++;
        s.promptTokens += usage.promptTokens;
        s.completionTokens += usage.completionTokens;
        s.cacheHitTokens += usage.cacheHitTokens;
        s.cacheMissTokens += usage.cacheMissTokens;
        s.reasoningTokens += usage.reasoningTokens ?? 0;
        if (messagesRef) entry.messagesRef = () => messagesRef;
        if (this.onRecord) {
          try {
            this.onRecord({
              ts: nowIso(this.timezone),
              sessionId: id,
              role: s.role,
              label: s.label,
              model: model ?? '',
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              cacheHitTokens: usage.cacheHitTokens,
              cacheMissTokens: usage.cacheMissTokens,
              reasoningTokens: usage.reasoningTokens ?? 0,
              ...(extra?.prefixHash ? { prefixHash: extra.prefixHash } : {}),
              ...(extra?.charges ? { charges: structuredClone(extra.charges) } : {}),
            });
          } catch {
            // 持久化观察失败不改变session本身的运行状态。
          }
        }
        this.emit();
      },
      close: () => {
        if (closed) return;
        closed = true;
        entry.stats.endedAt = nowIso(this.timezone);
        this.pruneClosed();
        this.emit();
      },
    };
  }

  /** 全部session统计(进行中在前,新的在前) */
  list(): SessionStats[] {
    const out: SessionStats[] = [];
    for (const e of this.entries.values()) {
      const s = e.stats;
      const denom = s.cacheHitTokens + s.cacheMissTokens;
      out.push({
        ...s,
        cacheHitRate: denom > 0 ? s.cacheHitTokens / denom : null,
        messageCount: this.countMessages(e),
      });
    }
    return out.sort((a, b) => {
      const ra = a.endedAt === null ? 0 : 1;
      const rb = b.endedAt === null ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return b.startedAt.localeCompare(a.startedAt);
    });
  }

  /**
   * 统计清零(web运维动作):进行中的session保留条目但usage归零、
   * 计时重置(句柄继续有效);已结束的条目移除。
   */
  reset(): void {
    for (const [id, e] of [...this.entries]) {
      if (e.stats.endedAt !== null) {
        this.entries.delete(id);
        continue;
      }
      e.stats.calls = 0;
      e.stats.promptTokens = 0;
      e.stats.completionTokens = 0;
      e.stats.cacheHitTokens = 0;
      e.stats.cacheMissTokens = 0;
      e.stats.reasoningTokens = 0;
      e.stats.startedAt = nowIso(this.timezone);
    }
    this.emit();
  }

  /** 某session当前消息流(引用实时序列化);未知id或无引用→null */
  messages(id: string): readonly ContextRecord[] | null {
    const e = this.entries.get(id);
    if (!e?.messagesRef) return null;
    try {
      return e.messagesRef();
    } catch {
      return null;
    }
  }


  private countMessages(e: Entry): number {
    if (!e.messagesRef) return 0;
    try {
      return e.messagesRef().length;
    } catch {
      return 0;
    }
  }

  /** 已结束session只留最近CLOSED_KEEP个(按结束时间;常驻条目永不清) */
  private pruneClosed(): void {
    const closed = [...this.entries.values()]
      .filter((e) => e.stats.endedAt !== null && !e.pinned)
      .sort((a, b) => (b.stats.endedAt ?? '').localeCompare(a.stats.endedAt ?? ''));
    for (const e of closed.slice(CLOSED_KEEP)) {
      this.entries.delete(e.stats.id);
    }
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* 观察者异常不影响主流程 */
      }
    }
  }
}
