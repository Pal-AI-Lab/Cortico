/**
 * 事件库:按 run 分片的 JSONL,`data/runs/<run>/events.jsonl` 一行一个 EventEnvelope。
 * cursor 跨 run 全局单调:开机时从已有分片的末行续号。当前 run 常驻内存,更早的
 * 分片按 cursor / ts 区间按需装载,只缓存最近一次查询读到的那些;range / around / grep
 * 跨分片作答。
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EventEnvelope,
  EventGrepHit,
  EventGrepQuery,
  EventRangeQuery,
  EventStore,
  Logger,
} from './types.ts';
import { listRuns, runsDirOf } from './run.ts';
import { nullLogger } from './util.ts';

export interface JsonlEventStoreOptions {
  dataDir: string;
  /** 当前 run id;新事件写进它的分片 */
  run: string;
  log?: Logger;
}

interface Segment {
  run: string;
  file: string;
  first: number;
  last: number;
  firstTs: string;
  lastTs: string;
  /** 装载后的记录,按 cursor 升序 */
  events: EventEnvelope[] | null;
}

const EDGE_BYTES = 64 * 1024;
const EVENTS_FILE = 'events.jsonl';

function parseLine(line: string): EventEnvelope | null {
  try {
    const e = JSON.parse(line) as EventEnvelope;
    return Number.isInteger(e.cursor) && typeof e.ts === 'string' ? e : null;
  } catch {
    return null;
  }
}

/** 不整读文件:头尾各取一段,拿首末两条的 cursor 与 ts。 */
function readEdges(file: string): { first: EventEnvelope; last: EventEnvelope } | null {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    const headLen = Math.min(size, EDGE_BYTES);
    const head = Buffer.alloc(headLen);
    readSync(fd, head, 0, headLen, 0);
    const headLines = head.toString('utf8').split('\n');
    const first = headLines.map((l) => l.trim()).filter(Boolean).map(parseLine).find((e) => e !== null);
    if (!first) return null;
    const tailStart = Math.max(0, size - EDGE_BYTES);
    const tail = Buffer.alloc(size - tailStart);
    readSync(fd, tail, 0, size - tailStart, tailStart);
    const tailLines = tail.toString('utf8').split('\n');
    if (tailStart > 0) tailLines.shift();
    const last = tailLines.map((l) => l.trim()).filter(Boolean).map(parseLine).reverse().find((e) => e !== null);
    return { first, last: last ?? first };
  } finally {
    closeSync(fd);
  }
}

function lowerBound(events: EventEnvelope[], cursor: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].cursor < cursor) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class JsonlEventStore implements EventStore {
  private readonly log: Logger;
  private readonly run: string;
  private readonly segments: Segment[] = [];
  private readonly current: Segment;
  /** 下一条事件拿到的 cursor */
  private next = 1;
  /**
   * 本实例记录的分片字节数；写入前的大小变化可能来自其他写入方。
   * 用 stat 比较大小，避免每次追加都读取全部文件。
   */
  private expectedSize = 0;
  /** 文件大小不符的错误只报告一次。 */
  private concurrencyReported = false;
  private appendListeners: Array<(e: EventEnvelope) => void> = [];
  /**
   * 最近一次查询(get / range / around / grep,grep 为每条命中取上下文的 around 也各算一次)
   * 读到的历史分片。其余历史分片在查询结束时、以及从磁盘装载新分片之前释放,所以缓存里的
   * 历史分片不超过一次查询要读的那些;连续查询落在同一批分片上时不重读磁盘。
   */
  private readonly touched = new Set<Segment>();

  constructor(opts: JsonlEventStoreOptions) {
    this.log = opts.log ?? nullLogger();
    this.run = opts.run;
    const runsDir = runsDirOf(opts.dataDir);
    for (const id of listRuns(opts.dataDir)) {
      if (id === this.run) continue;
      const file = join(runsDir, id, EVENTS_FILE);
      if (!existsSync(file)) continue;
      let edges: { first: EventEnvelope; last: EventEnvelope } | null;
      try {
        edges = readEdges(file);
      } catch (error) {
        this.log.warn('事件分片读不出头尾,跳过', { run: id, err: error });
        continue;
      }
      if (!edges) continue;
      this.segments.push({
        run: id, file, first: edges.first.cursor, last: edges.last.cursor,
        firstTs: edges.first.ts, lastTs: edges.last.ts, events: null,
      });
      this.next = Math.max(this.next, edges.last.cursor + 1);
    }
    const currentFile = join(runsDir, this.run, EVENTS_FILE);
    mkdirSync(join(runsDir, this.run), { recursive: true });
    this.current = { run: this.run, file: currentFile, first: 0, last: 0, firstTs: '', lastTs: '', events: [] };
    if (existsSync(currentFile)) {
      const raw = readFileSync(currentFile, 'utf8');
      this.expectedSize = Buffer.byteLength(raw, 'utf8');
      this.current.events = this.parseAll(raw, this.run);
      const events = this.current.events;
      if (events.length) {
        this.current.first = events[0].cursor;
        this.current.last = events[events.length - 1].cursor;
        this.current.firstTs = events[0].ts;
        this.current.lastTs = events[events.length - 1].ts;
        this.next = Math.max(this.next, this.current.last + 1);
      }
    }
    this.segments.push(this.current);
  }

  private parseAll(raw: string, run: string): EventEnvelope[] {
    const out: EventEnvelope[] = [];
    let skipped = 0;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const e = parseLine(t);
      if (!e) { skipped++; continue; }
      if (out.length && e.cursor <= out[out.length - 1].cursor) { skipped++; continue; }
      out.push(e);
    }
    if (skipped) this.log.warn('事件分片有损坏或乱序行,已跳过', { run, skipped });
    return out;
  }

  private load(segment: Segment): EventEnvelope[] {
    if (segment !== this.current) this.touched.add(segment);
    if (segment.events) return segment.events;
    this.releaseUntouched();
    let raw = '';
    try {
      raw = readFileSync(segment.file, 'utf8');
    } catch (error) {
      this.log.warn('事件分片读取失败', { run: segment.run, err: error });
    }
    segment.events = this.parseAll(raw, segment.run);
    return segment.events;
  }

  private releaseUntouched(): void {
    for (const s of this.segments) {
      if (s !== this.current && !this.touched.has(s)) s.events = null;
    }
  }

  private query<T>(read: () => T): T {
    this.touched.clear();
    try {
      return read();
    } finally {
      this.releaseUntouched();
    }
  }

  append(e: Omit<EventEnvelope, 'cursor'>): EventEnvelope {
    this.checkExclusiveWrite();
    const envelope: EventEnvelope = { ...e, cursor: this.next++, run: this.run };
    const events = this.current.events!;
    events.push(envelope);
    if (events.length === 1) { this.current.first = envelope.cursor; this.current.firstTs = envelope.ts; }
    this.current.last = envelope.cursor;
    this.current.lastTs = envelope.ts;
    const line = JSON.stringify(envelope) + '\n';
    appendFileSync(this.current.file, line, 'utf8');
    this.expectedSize += Buffer.byteLength(line, 'utf8');
    for (const cb of this.appendListeners) {
      try { cb(envelope); } catch { /* 观察者异常不影响主流程 */ }
    }
    return envelope;
  }

  /** 大小与本实例记录不符时报告文件变化，仍继续写入；独占检查由 instanceLock 负责。 */
  private checkExclusiveWrite(): void {
    if (this.concurrencyReported) return;
    let onDisk = 0;
    try {
      onDisk = existsSync(this.current.file) ? statSync(this.current.file).size : 0;
    } catch {
      return; // 读不到文件状态不影响写入
    }
    if (onDisk === this.expectedSize) return;
    this.concurrencyReported = true;
    this.log.error('事件库被本进程之外的写入改动过,疑似另一个实例在写同一个事件库', {
      expectedSize: this.expectedSize,
      onDiskSize: onDisk,
      file: this.current.file,
    });
    this.expectedSize = onDisk;
  }

  /** 事件追加订阅，供控制台实时观察。 */
  onAppend(cb: (e: EventEnvelope) => void): void {
    this.appendListeners.push(cb);
  }

  /** 当前 run 分片里的条数 */
  currentCount(): number {
    return this.current.events!.length;
  }

  get(cursor: number): EventEnvelope | undefined {
    if (!Number.isInteger(cursor) || cursor < 1) return undefined;
    const segment = this.segments.find((s) => s.first <= cursor && cursor <= s.last);
    if (!segment) return undefined;
    return this.query(() => {
      const events = this.load(segment);
      const i = lowerBound(events, cursor);
      return events[i]?.cursor === cursor ? events[i] : undefined;
    });
  }

  latestCursor(): number {
    return this.next - 1;
  }

  private segmentsIn(q: { fromCursor?: number; toCursor?: number; fromTs?: string; toTs?: string }): Segment[] {
    return this.segments.filter((s) => {
      if (s.last === 0) return s === this.current;
      if (q.fromCursor !== undefined && s.last < q.fromCursor) return false;
      if (q.toCursor !== undefined && s.first > q.toCursor) return false;
      if (q.fromTs !== undefined && s.lastTs < q.fromTs) return false;
      if (q.toTs !== undefined && s.firstTs > q.toTs) return false;
      return true;
    });
  }

  range(q: EventRangeQuery): EventEnvelope[] {
    return this.query(() => this.scanRange(q));
  }

  private scanRange(q: EventRangeQuery): EventEnvelope[] {
    const limit = q.limit !== undefined && q.limit >= 0 ? q.limit : undefined;
    // 无起点区间的 limit 查询只要最近的几条:从尾部分片倒着凑,不触碰更早的历史
    if (limit !== undefined && q.fromCursor === undefined && q.fromTs === undefined) {
      if (limit === 0) return [];
      const matched: EventEnvelope[] = [];
      for (const segment of [...this.segmentsIn(q)].reverse()) {
        const events = this.load(segment);
        for (let i = events.length - 1; i >= 0; i--) {
          const e = events[i];
          if (q.toCursor !== undefined && e.cursor > q.toCursor) continue;
          if (q.toTs !== undefined && e.ts > q.toTs) continue;
          if (q.senderKey !== undefined && e.senderKey !== q.senderKey) continue;
          if (q.source !== undefined && e.source !== q.source) continue;
          if (q.origin !== undefined && e.origin !== q.origin) continue;
          matched.push(e);
          if (matched.length >= limit) { matched.reverse(); return matched; }
        }
      }
      matched.reverse();
      return matched;
    }
    const matched: EventEnvelope[] = [];
    for (const segment of this.segmentsIn(q)) {
      const events = this.load(segment);
      const start = q.fromCursor !== undefined ? lowerBound(events, q.fromCursor) : 0;
      for (let i = start; i < events.length; i++) {
        const e = events[i];
        if (q.toCursor !== undefined && e.cursor > q.toCursor) break;
        if (q.fromTs !== undefined && e.ts < q.fromTs) continue;
        if (q.toTs !== undefined && e.ts > q.toTs) continue;
        if (q.senderKey !== undefined && e.senderKey !== q.senderKey) continue;
        if (q.source !== undefined && e.source !== q.source) continue;
        if (q.origin !== undefined && e.origin !== q.origin) continue;
        matched.push(e);
      }
    }
    // limit从区间尾部取(最近优先),返回仍按游标升序
    if (limit !== undefined && matched.length > limit) {
      return matched.slice(matched.length - limit);
    }
    return matched;
  }

  around(cursor: number, before: number, after: number): EventEnvelope[] {
    const latest = this.latestCursor();
    if (latest === 0) return [];
    const center = Math.min(Math.max(cursor, 1), latest);
    return this.range({ fromCursor: center - Math.max(0, before), toCursor: center + Math.max(0, after) });
  }

  grep(q: EventGrepQuery): EventGrepHit[] {
    return this.query(() => this.scanGrep(q));
  }

  private scanGrep(q: EventGrepQuery): EventGrepHit[] {
    const kw = q.keyword.toLowerCase();
    const ctx = Math.max(0, q.context);
    const hits: EventGrepHit[] = [];
    for (const segment of this.segmentsIn(q)) {
      for (const e of this.load(segment)) {
        if (q.senderKey !== undefined && e.senderKey !== q.senderKey) continue;
        if (q.source !== undefined && e.source !== q.source) continue;
        if (q.origin !== undefined && e.origin !== q.origin) continue;
        if (q.fromTs !== undefined && e.ts < q.fromTs) continue;
        if (q.toTs !== undefined && e.ts > q.toTs) continue;
        if (!e.text.toLowerCase().includes(kw)) continue;
        // 邻近记录不经过筛选；重叠窗口保持分开。
        hits.push({ hitCursor: e.cursor, events: this.around(e.cursor, ctx, ctx) });
        if (q.limit !== undefined && hits.length >= q.limit) return hits;
      }
    }
    return hits;
  }

  /**
   * 清空当前 run 的分片(web 运维动作):删文件与内存里这一段,游标不回退,
   * 更早的 run 不受影响。返回清掉的条数。
   */
  clear(): number {
    const n = this.current.events!.length;
    this.current.events = [];
    this.current.first = 0;
    this.current.last = 0;
    this.current.firstTs = '';
    this.current.lastTs = '';
    if (existsSync(this.current.file)) rmSync(this.current.file);
    this.expectedSize = 0;
    this.log.warn('当前 run 的事件分片已清空', { cleared: n, run: this.run });
    return n;
  }
}
