/**
 * worlds-qq测试公用件:内存EventStore stub、FakeHost、waitUntil轮询。
 */
import type {
  EventEnvelope,
  EventGrepHit,
  EventGrepQuery,
  EventRangeQuery,
  EventStore,
  WorldHost,
  LLMUsage,
  Logger,
  PushOptions, BlobInput, BlobRef } from '../../../src/core/types.ts';
import { nullLogger } from '../../../src/core/util.ts';
import { createHash } from 'node:crypto';
import { withBlobLines } from '../../../src/core/blobs.ts';

export class FakeStore implements EventStore {
  events: EventEnvelope[] = [];
  private seq = 0;

  append(e: Omit<EventEnvelope, 'cursor'>): EventEnvelope {
    const env: EventEnvelope = { ...e, cursor: ++this.seq };
    this.events.push(env);
    return env;
  }

  get(cursor: number): EventEnvelope | undefined {
    return this.events.find((e) => e.cursor === cursor);
  }

  latestCursor(): number {
    return this.seq;
  }

  range(q: EventRangeQuery): EventEnvelope[] {
    let out = this.events.filter(
      (e) =>
        (q.fromCursor === undefined || e.cursor >= q.fromCursor) &&
        (q.toCursor === undefined || e.cursor <= q.toCursor) &&
        (q.fromTs === undefined || e.ts >= q.fromTs) &&
        (q.toTs === undefined || e.ts <= q.toTs) &&
        (q.senderKey === undefined || e.senderKey === q.senderKey) &&
        (q.source === undefined || e.source === q.source) &&
        (q.origin === undefined || e.origin === q.origin),
    );
    if (q.limit !== undefined && out.length > q.limit) {
      out = out.slice(out.length - q.limit); // 从尾部取,最近优先
    }
    return out;
  }

  around(cursor: number, before: number, after: number): EventEnvelope[] {
    const idx = this.events.findIndex((e) => e.cursor === cursor);
    if (idx < 0) return [];
    return this.events.slice(Math.max(0, idx - before), idx + after + 1);
  }

  grep(q: EventGrepQuery): EventGrepHit[] {
    const hits: EventGrepHit[] = [];
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      if (!e.text.includes(q.keyword)) continue;
      if (q.senderKey !== undefined && e.senderKey !== q.senderKey) continue;
      if (q.source !== undefined && e.source !== q.source) continue;
      if (q.fromTs !== undefined && e.ts < q.fromTs) continue;
      if (q.toTs !== undefined && e.ts > q.toTs) continue;
      hits.push({
        hitCursor: e.cursor,
        events: this.events.slice(
          Math.max(0, i - q.context),
          i + q.context + 1,
        ),
      });
      if (q.limit !== undefined && hits.length >= q.limit) break;
    }
    return hits;
  }

}

export interface PushedRecord {
  event: EventEnvelope;
  opts?: PushOptions;
}

export class FakeHost implements WorldHost {
  store = new FakeStore();
  pushed: PushedRecord[] = [];
  pushDeferred(): void {}
  /** 模型事实(运行时查询;默认这个模型什么 mime 都不吃) */
  modelFacts = { model: () => 'fake-model', accepts: () => false, contextWindow: () => undefined };
  /** World 自愿上报的用量(测试里只收集,断言归账走到了) */
  reportedUsage: Array<{ usage: LLMUsage; model?: string; label?: string }> = [];
  notes: string[] = [];
  reportUsage = (usage: LLMUsage, opts?: { model?: string; label?: string }): void => {
    this.reportedUsage.push({ usage, model: opts?.model, label: opts?.label });
  };
  /** 内存附件库:pushEvent 落库时给字节发 `log:` 句柄;putBlob 让用例先放一份进去 */
  private readonly blobBytes = new Map<string, { bytes: Uint8Array; mime: string }>();
  /** 分区落在哪个目录(历史遗留参数,不再使用) */
  readonly workspaceDir: string;
  log: Logger = nullLogger();
  /** 测试可填入"当下已积待投递"的事件,draft用drainPendingEvents取走 */
  pendingForDrain: EventEnvelope[] = [];

  constructor(workspaceDir = '') {
    this.workspaceDir = workspaceDir;
  }

  putBlob(bytes: Uint8Array, mime: string, handle = `log:${createHash('sha1').update(bytes).digest('hex').slice(0, 12)}.png`): string {
    this.blobBytes.set(handle, { bytes, mime });
    return handle;
  }

  blob = (handle: string): { bytes: Uint8Array; mime: string } | null => this.blobBytes.get(handle) ?? null;

  async pushEvent(e: Omit<EventEnvelope, 'cursor' | 'blobs'> & { blobs?: BlobInput[] }, opts?: PushOptions): Promise<EventEnvelope> {
    const { blobs: inputs, ...rest } = e;
    const blobs: BlobRef[] | undefined = inputs?.length
      ? inputs.map((b) => 'bytes' in b
        ? { handle: this.putBlob(b.bytes, b.mime), mime: b.mime, ...(b.name ? { name: b.name } : {}), fallbackText: b.fallbackText }
        : { handle: b.handle, mime: this.blobBytes.get(b.handle)?.mime ?? 'application/octet-stream', fallbackText: b.fallbackText })
      : undefined;
    const env = this.store.append({
      ...rest,
      origin: rest.origin ?? 'external',
      text: withBlobLines(e.text, blobs),
      ...(blobs ? { blobs } : {}),
    });
    this.pushed.push({ event: env, opts });
    return env;
  }

  async drainPendingEvents(filter: (e: EventEnvelope) => boolean): Promise<EventEnvelope[]> {
    const drained = this.pendingForDrain.filter(filter);
    this.pendingForDrain = this.pendingForDrain.filter((e) => !filter(e));
    return drained;
  }
}

/** 轮询等条件成立;超时抛错(带label方便定位) */
export async function waitUntil(
  cond: () => boolean,
  label = 'condition',
  timeoutMs = 5000,
  intervalMs = 15,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (cond()) return;
  throw new Error(`waitUntil超时: ${label}`);
}
