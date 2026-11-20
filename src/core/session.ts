/** Session context is append-only between lifecycle resets. */
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ContextRecord } from '../protocol/open-responses/context.ts';
import { hasRole } from '../protocol/open-responses/context-helpers.ts';
import { ContextLog, type ContextLoadRepair } from '../protocol/open-responses/context-log.ts';
import { estimateMessagesTokens } from './util.ts';


export interface SessionPrefixChange {
  removed: number;
  previousLength: number;
  entry: ContextRecord;
}

export class SessionLog {
  private readonly context: ContextLog;
  get records(): readonly ContextRecord[] { return this.context.records; }
  private appendListeners: Array<(msg: ContextRecord, index: number) => void> = [];
  private resetListeners: Array<(messages: ContextRecord[], prefix?: SessionPrefixChange) => void> = [];

  /** stamp:入库时刻的来源(config 时区的 ISO);不给则消息不带 ts */
  constructor(
    dataDir: string,
    fileName = 'session-main.jsonl',
    stamp?: () => string,
  ) {
    this.context = new ContextLog(join(dataDir, fileName), stamp);
  }

  /** 每次 append 后通知 Web 调试监听器;监听器异常与会话写入隔离。 */
  onAppend(cb: (msg: ContextRecord, index: number) => void): void {
    this.appendListeners.push(cb);
  }

  /** 截断/重置后回调(整个数组被替换) */
  onReset(cb: (messages: ContextRecord[], prefix?: SessionPrefixChange) => void): void {
    this.resetListeners.push(cb);
  }

  append(msg: ContextRecord): void {
    this.context.append(msg);
    const stored = this.records[this.records.length - 1];
    for (const cb of this.appendListeners) {
      try { cb(stored, this.records.length - 1); } catch { /* 观察者异常不影响主流程 */ }
    }
  }

  /** 返回对未写完末行的修复；其他损坏行抛错。 */
  load(): ContextLoadRepair | null { return this.context.load(); }

  /** 整体替换：先写临时文件，再 rename 覆盖目标文件。 */
  reset(messages: readonly ContextRecord[]): void {
    this.context.reset(messages);
    this.notifyReset();
  }

  /** Replace all leading system items and publish the matching tool schema generation to observers. */
  async replaceSystemPrefix(entry: ContextRecord, active: () => boolean = () => true, applyTools?: () => void): Promise<number | null> {
    if (!hasRole(entry, 'system')) throw new Error('Expected a system prefix');
    if (!active()) return null;
    let removed = 0;
    while (removed < this.records.length && hasRole(this.records[removed], 'system')) removed++;
    const previous = this.records[0];
    // Rebuilding the same system message generates a fresh item ID. Preserve its original ID and ingestion stamp.
    if (removed === 1 && isDeepStrictEqual({ ...entry.item, id: previous.item.id }, previous.item)
        && isDeepStrictEqual({ ...previous.context, ts: previous.context.ts },
          { ...entry.context, ts: entry.context.ts ?? previous.context.ts })) {
      applyTools?.();
      this.notifyReset({ removed, previousLength: this.records.length, entry: previous });
      return this.records.length - removed;
    }
    let kept = 0;
    const replaced = await this.context.replacePrefix(removed, entry, active, () => {
      kept = this.records.length - 1;
      applyTools?.();
      this.notifyReset({ removed, previousLength: kept + removed, entry: this.records[0] });
    });
    return replaced ? kept : null;
  }

  private notifyReset(prefix?: SessionPrefixChange): void {
    const snapshot = this.records;
    for (const cb of this.resetListeners) {
      try { cb([...snapshot], prefix); } catch { /* 观察者异常不影响主流程 */ }
    }
  }

  estTokens(): number {
    return estimateMessagesTokens(this.records);
  }


}
