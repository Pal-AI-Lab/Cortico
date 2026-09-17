/**
 * 通用持久定时器:到点回调持有方、跨重启恢复。载荷不透明——
 * 闹钟的备注、阻断、关键词这些语义归持有它的Persona。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger, TimerEntry, TimersApi } from './types.ts';
import { nullLogger, shortId } from './util.ts';

const MAX_TIMEOUT = 2 ** 31 - 1; // setTimeout上限(~24.8天)

export class TimerStore implements TimersApi {
  private file: string;
  private log: Logger;
  private entries: TimerEntry[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;
  private dueHandler: ((entry: TimerEntry) => void) | null = null;

  /** 构造时即读盘,attach 阶段就能 list();到期定时在 start() 才布防。 */
  constructor(dataDir: string, log: Logger = nullLogger()) {
    this.file = join(dataDir, 'timers.json');
    this.log = log;
    this.load();
  }

  onDue(handler: (entry: TimerEntry) => void): void {
    this.dueHandler = handler;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const e of [...this.entries]) this.arm(e);
  }

  stop(): void {
    this.started = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  set(atIso: string, payload: Record<string, unknown> = {}): { ok: true; id: string } | { ok: false; error: string } {
    if (Number.isNaN(Date.parse(atIso))) {
      return { ok: false, error: `could not parse time "${atIso}"` };
    }
    const entry: TimerEntry = { id: shortId('wake_'), atIso, payload };
    this.entries.push(entry);
    this.save();
    // 已到期的也等 set 返回后再回调,持有方先拿到 id。
    if (this.started) this.arm(entry, 'next-tick');
    return { ok: true, id: entry.id };
  }

  cancel(id: string): boolean {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.save();
    return true;
  }

  list(): ReadonlyArray<TimerEntry> {
    return this.entries;
  }

  clearAll(): number {
    const n = this.entries.length;
    this.entries = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.save();
    if (n > 0) this.log.warn('定时器已全部清除', { cleared: n });
    return n;
  }

  /** 已到期的条目按 whenDue 立即回调或下一个宏任务回调;start() 用前者。 */
  private arm(entry: TimerEntry, whenDue: 'now' | 'next-tick' = 'now'): void {
    const delay = Date.parse(entry.atIso) - Date.now();
    if (delay <= 0 && whenDue === 'now') {
      this.fire(entry.id);
      return;
    }
    const existing = this.timers.get(entry.id);
    if (existing) clearTimeout(existing);
    if (delay > MAX_TIMEOUT) {
      // 超长延迟按 MAX_TIMEOUT 分段重新 arm。
      this.timers.set(entry.id, setTimeout(() => this.arm(entry), MAX_TIMEOUT));
    } else {
      this.timers.set(entry.id, setTimeout(() => this.fire(entry.id), Math.max(0, delay)));
    }
  }

  private fire(id: string): void {
    if (!this.started) return;
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return;
    const entry = this.entries[idx];
    this.entries.splice(idx, 1);
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.save();
    if (this.dueHandler) this.dueHandler(entry);
    else this.log.warn('定时器到期但无人认领', { id, atIso: entry.atIso });
  }

  private load(): void {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as TimerEntry[];
        this.entries = Array.isArray(raw) ? raw : [];
      } catch {
        this.log.warn('timers.json损坏,已重置为空');
        this.entries = [];
      }
    }
  }

  private save(): void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2), 'utf8');
    if (existsSync(this.file)) rmSync(this.file);
    renameSync(tmp, this.file);
  }
}
