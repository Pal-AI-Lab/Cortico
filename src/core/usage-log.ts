/** Append-only usage ledger. Failed writes remain queued and are reported to the operator. */
import { JsonlLog } from './jsonl-log.ts';
import type { UsageRecord } from './types.ts';

function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== 'object') return false;
  const rec = value as UsageRecord;
  return rec.version === 2 && typeof rec.ts === 'string';
}

export class UsageLog extends JsonlLog<UsageRecord> {
  constructor(file: string, report: (message: string) => void = console.error) {
    super(file, {
      label: 'Usage ledger',
      isValid: isUsageRecord,
      idOf: (record) => record.recordId ?? record.attempt?.id,
      report,
    });
  }

  override append(rec: UsageRecord): void {
    super.append(structuredClone({ ...rec, version: 2, recordId: rec.recordId ?? rec.attempt?.id ?? crypto.randomUUID() }));
  }
}
