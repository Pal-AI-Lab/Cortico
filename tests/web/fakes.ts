/**
 * tests/web 共享fake:内存事件库 + 捕获pushEvent的fake host。
 */
import { createHash } from 'node:crypto';
import type {
  EventEnvelope, EventGrepHit, EventGrepQuery, EventRangeQuery,
  EventStore, WorldHost, Logger, ModelFacts, PushOptions, BlobInput, BlobRef,
} from '../../src/core/types.ts';
import { withBlobLines } from '../../src/core/blobs.ts';
import { nullLogger } from '../../src/core/util.ts';

export class FakeStore implements EventStore {
  events: EventEnvelope[] = [];

  append(e: Omit<EventEnvelope, 'cursor'>): EventEnvelope {
    const ev: EventEnvelope = { ...e, cursor: this.events.length + 1 };
    this.events.push(ev);
    return ev;
  }

  get(cursor: number): EventEnvelope | undefined {
    return this.events.find((e) => e.cursor === cursor);
  }

  latestCursor(): number {
    return this.events.length ? this.events[this.events.length - 1].cursor : 0;
  }

  range(q: EventRangeQuery): EventEnvelope[] {
    let out = this.events.filter((e) =>
      (q.fromCursor === undefined || e.cursor >= q.fromCursor) &&
      (q.toCursor === undefined || e.cursor <= q.toCursor) &&
      (q.fromTs === undefined || Date.parse(e.ts) >= Date.parse(q.fromTs)) &&
      (q.toTs === undefined || Date.parse(e.ts) <= Date.parse(q.toTs)) &&
      (q.senderKey === undefined || e.senderKey === q.senderKey) &&
      (q.source === undefined || e.source === q.source));
    if (q.limit !== undefined && out.length > q.limit) out = out.slice(out.length - q.limit);
    return out;
  }

  around(cursor: number, before: number, after: number): EventEnvelope[] {
    const idx = this.events.findIndex((e) => e.cursor === cursor);
    if (idx < 0) return [];
    return this.events.slice(Math.max(0, idx - before), Math.min(this.events.length, idx + after + 1));
  }

  grep(q: EventGrepQuery): EventGrepHit[] {
    const hits: EventGrepHit[] = [];
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      if (!e.text.includes(q.keyword)) continue;
      if (q.senderKey !== undefined && e.senderKey !== q.senderKey) continue;
      if (q.source !== undefined && e.source !== q.source) continue;
      if (q.fromTs !== undefined && Date.parse(e.ts) < Date.parse(q.fromTs)) continue;
      if (q.toTs !== undefined && Date.parse(e.ts) > Date.parse(q.toTs)) continue;
      hits.push({
        hitCursor: e.cursor,
        events: this.events.slice(Math.max(0, i - q.context), Math.min(this.events.length, i + q.context + 1)),
      });
      if (q.limit !== undefined && hits.length >= q.limit) break;
    }
    return hits;
  }

}

export interface PushedRecord {
  e: Omit<EventEnvelope, 'cursor'>;
  opts?: PushOptions;
}

export class FakeHost implements WorldHost {
  pushed: PushedRecord[] = [];
  pushDeferred(): void {}
  store = new FakeStore();
  /** 内存附件库:pushEvent 落库时按内容哈希发 `log:` 句柄,blob() 回同一份字节(终端取图走这里)。 */
  private readonly blobBytes = new Map<string, { bytes: Uint8Array; mime: string }>();
  internBlobs(inputs: BlobInput[] | undefined): BlobRef[] | undefined {
    if (!inputs?.length) return undefined;
    return inputs.map((b) => {
      if (!('bytes' in b)) return { handle: b.handle, mime: this.blobBytes.get(b.handle)?.mime ?? 'application/octet-stream', fallbackText: b.fallbackText };
      const ext = b.mime === 'image/png' ? '.png' : b.mime === 'image/jpeg' ? '.jpg' : '.bin';
      const handle = 'log:' + createHash('sha1').update(b.bytes).digest('hex').slice(0, 12) + ext;
      this.blobBytes.set(handle, { bytes: b.bytes, mime: b.mime });
      return { handle, mime: b.mime, ...(b.name ? { name: b.name } : {}), fallbackText: b.fallbackText };
    });
  }
  /** 直接放一份字节进内存附件库(回放用例先造历史),返回句柄 */
  putBlob(bytes: Uint8Array, mime: string): string {
    return this.internBlobs([{ bytes, mime, fallbackText: '' }])![0].handle;
  }
  blob = (handle: string): { bytes: Uint8Array; mime: string } | null => this.blobBytes.get(handle) ?? null;
  modelFacts: ModelFacts = { model: () => 'fake-model', accepts: () => false, contextWindow: () => undefined };
  notes: string[] = [];
  reportUsage = (): void => {};
  log: Logger = nullLogger();

  async pushEvent(e: Omit<EventEnvelope, 'cursor' | 'blobs'> & { blobs?: BlobInput[] }, opts?: PushOptions): Promise<EventEnvelope> {
    const { blobs: inputs, ...rest } = e;
    const blobs = this.internBlobs(inputs);
    const stored = { ...rest, text: withBlobLines(e.text, blobs), ...(blobs ? { blobs } : {}) };
    this.pushed.push({ e: stored, opts });
    return this.store.append(stored);
  }

  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
}
