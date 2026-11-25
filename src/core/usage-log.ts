import { JsonlLedger } from './jsonl-ledger.ts';
import type { UsageRecord } from './types.ts';

export class UsageLog extends JsonlLedger<UsageRecord> {
  constructor(file: string, report?: (message: string) => void) {
    super(file, {
      label: 'Usage ledger',
      isRecord(value): value is UsageRecord {
        const record = value as UsageRecord | null;
        return !!record && record.version === 2 && typeof record.ts === 'string';
      },
      recordId: record => record.recordId ?? record.attempt?.id,
      report,
    });
  }

  append(rec: UsageRecord): void {
    this.appendRecords([structuredClone({ ...rec, version: 2, recordId: rec.recordId ?? rec.attempt?.id ?? crypto.randomUUID() })]);
  }
}
