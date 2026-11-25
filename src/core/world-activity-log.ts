/**
 * One row per World and minute in a run. If writes are succeeding, an abrupt exit can lose
 * at most the minute still in memory.
 */
import { JsonlLedger } from './jsonl-ledger.ts';
import { nowIso } from './util.ts';

export const WORLD_ACTIVITY_LOG_FILE = 'world-activity.jsonl';
export const WORLD_ACTIVITY_RECORD_VERSION = 1;
export const WORLD_ACTIVITY_MINUTE_MS = 60_000;

export interface WorldActivityRecord {
  version: typeof WORLD_ACTIVITY_RECORD_VERSION;
  recordId: string;
  ts: string;
  run: string;
  world: string;
  events: number;
  rounds: number;
}

interface WorldActivityLogOptions {
  run: string;
  timezone: () => string;
  report?: (message: string) => void;
}

export class WorldActivityLog extends JsonlLedger<WorldActivityRecord> {
  private minute: number | null = null;
  private readonly active = new Map<string, WorldActivityRecord>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(file: string, private readonly activityOptions: WorldActivityLogOptions) {
    super(file, {
      label: 'World activity ledger',
      isRecord(value): value is WorldActivityRecord {
        const row = value as WorldActivityRecord | null;
        return !!row && row.version === WORLD_ACTIVITY_RECORD_VERSION
          && typeof row.recordId === 'string' && typeof row.ts === 'string'
          && typeof row.run === 'string' && typeof row.world === 'string'
          && Number.isSafeInteger(row.events) && row.events >= 0
          && Number.isSafeInteger(row.rounds) && row.rounds >= 0;
      },
      recordId: row => row.recordId,
      report: activityOptions.report,
    });
  }

  record(world: string, kind: 'events' | 'rounds', atMs = Date.now()): void {
    // Deployment offsets are whole minutes. Using the instant keeps both occurrences
    // of a repeated wall-clock minute at a daylight saving transition distinct.
    const minute = Math.floor(atMs / WORLD_ACTIVITY_MINUTE_MS);
    if (minute !== this.minute) {
      this.flushMinute();
      this.minute = minute;
    }
    let row = this.active.get(world);
    if (!row) {
      row = {
        version: WORLD_ACTIVITY_RECORD_VERSION,
        recordId: crypto.randomUUID(),
        ts: nowIso(this.activityOptions.timezone(), new Date(atMs)),
        run: this.activityOptions.run,
        world,
        events: 0,
        rounds: 0,
      };
      this.active.set(world, row);
    }
    row[kind]++;
  }

  start(): void {
    if (this.timer === null) this.scheduleFlush();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.flushMinute();
  }

  override async readAll(keep: (row: WorldActivityRecord) => boolean = () => true): Promise<WorldActivityRecord[]> {
    const active = [...this.active.values()].filter(keep).map(row => ({ ...row }));
    const records = await super.readAll(keep);
    if (!active.length) return records;
    const ids = new Set(records.map(row => row.recordId));
    return [...records, ...active.filter(row => !ids.has(row.recordId))];
  }

  override count(): number | null {
    const count = super.count();
    return count === null ? null : count + this.active.size;
  }

  protected override resetAfterClear(): void {
    super.resetAfterClear();
    this.active.clear();
    this.minute = null;
  }

  private scheduleFlush(): void {
    const delay = WORLD_ACTIVITY_MINUTE_MS - Date.now() % WORLD_ACTIVITY_MINUTE_MS;
    this.timer = setTimeout(() => {
      if (this.minute !== Math.floor(Date.now() / WORLD_ACTIVITY_MINUTE_MS)) this.flushMinute();
      this.scheduleFlush();
    }, delay);
    this.timer.unref();
  }

  private flushMinute(): void {
    const rows = [...this.active.values()];
    this.active.clear();
    this.minute = null;
    this.appendRecords(rows);
  }
}
