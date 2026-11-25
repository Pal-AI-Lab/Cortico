/**
 * Append-only per-World activity ledger (`data/world-activity.jsonl`).
 * Counts are aggregated in memory to at most one row per World per deployment-timezone
 * wall-clock minute (`YYYY-MM-DDTHH:MM`) and flushed on minute rollover, on a minute-boundary
 * timer, or on stop(). An abnormal process exit can lose at most the current unflushed minute.
 */
import { JsonlLog } from './jsonl-log.ts';
import { nowIso } from './util.ts';

export const WORLD_ACTIVITY_VERSION = 1;
/** Prefix used for World-owned usage rows (`role: worlds.<worldId>`). */
export const WORLD_USAGE_ROLE_PREFIX = 'worlds.';
/** Wall-clock minute length in milliseconds. */
const MINUTE_MS = 60_000;
/** Margin past the minute boundary so the timer fires after wall-clock rollover. */
const TIMER_CUSHION_MS = 50;

export interface WorldActivityRecord {
  version: typeof WORLD_ACTIVITY_VERSION;
  recordId: string;
  ts: string;
  run: string;
  world: string;
  events: number;
  rounds: number;
}

export interface WorldActivityLogOptions {
  timezone: string;
  run: string;
  now?: () => Date;
  report?: (message: string) => void;
}

function isWorldActivityRecord(value: unknown): value is WorldActivityRecord {
  if (!value || typeof value !== 'object') return false;
  const rec = value as WorldActivityRecord;
  return (
    rec.version === WORLD_ACTIVITY_VERSION &&
    typeof rec.ts === 'string' &&
    typeof rec.run === 'string' &&
    typeof rec.world === 'string' &&
    typeof rec.events === 'number' &&
    typeof rec.rounds === 'number'
  );
}

interface ActiveBucket {
  minute: string;
  record: WorldActivityRecord;
}

export class WorldActivityLog {
  private readonly ledger: JsonlLog<WorldActivityRecord>;
  private readonly timezone: string;
  private readonly run: string;
  private readonly now: () => Date;
  private readonly current = new Map<string, ActiveBucket>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(file: string, opts: WorldActivityLogOptions) {
    this.timezone = opts.timezone;
    this.run = opts.run;
    this.now = opts.now ?? (() => new Date());
    this.ledger = new JsonlLog<WorldActivityRecord>(file, {
      label: 'World activity ledger',
      isValid: isWorldActivityRecord,
      idOf: (record) => record.recordId,
      report: opts.report,
    });
  }

  recordEvent(world: string, count = 1): void {
    if (count <= 0) return;
    this.bump(world, count, 0);
  }

  recordRound(world: string, count = 1): void {
    if (count <= 0) return;
    this.bump(world, 0, count);
  }

  private bump(world: string, events: number, rounds: number): void {
    const ts = nowIso(this.timezone, this.now());
    const minute = ts.slice(0, 16);
    this.flushCompleted(minute);
    const existing = this.current.get(world);
    if (existing) {
      existing.record.events += events;
      existing.record.rounds += rounds;
    } else {
      this.current.set(world, {
        minute,
        record: {
          version: WORLD_ACTIVITY_VERSION,
          recordId: crypto.randomUUID(),
          ts,
          run: this.run,
          world,
          events,
          rounds,
        },
      });
    }
    this.scheduleTimer();
  }

  private flushCompleted(currentMinute: string): void {
    for (const [world, bucket] of [...this.current.entries()]) {
      if (bucket.minute === currentMinute) continue;
      this.current.delete(world);
      this.ledger.append(bucket.record);
    }
  }

  private scheduleTimer(): void {
    if (this.timer || this.current.size === 0) return;
    const msIntoMinute = ((this.now().getTime() % MINUTE_MS) + MINUTE_MS) % MINUTE_MS;
    const delayMs = MINUTE_MS - msIntoMinute + TIMER_CUSHION_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      const minute = nowIso(this.timezone, this.now()).slice(0, 16);
      this.flushCompleted(minute);
      this.scheduleTimer();
    }, delayMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Seals all in-memory buckets and flushes the underlying ledger. */
  flush(): void {
    this.clearTimer();
    if (this.current.size === 0) {
      this.ledger.flush();
      return;
    }
    for (const [world, bucket] of [...this.current.entries()]) {
      this.current.delete(world);
      this.ledger.append(bucket.record);
    }
  }

  status(): { pending: number; error: string | null } {
    return this.ledger.status();
  }

  /** Persisted, pending, and current in-memory buckets matching `keep`. */
  async readAll(keep: (record: WorldActivityRecord) => boolean = () => true): Promise<WorldActivityRecord[]> {
    const persisted = await this.ledger.readAll(keep);
    if (this.current.size === 0) return persisted;
    const live: WorldActivityRecord[] = [];
    for (const bucket of this.current.values()) {
      if (keep(bucket.record)) live.push({ ...bucket.record });
    }
    return [...persisted, ...live];
  }

  async clear(): Promise<number> {
    this.clearTimer();
    const inMemory = this.current.size;
    this.current.clear();
    return (await this.ledger.clear()) + inMemory;
  }
}
