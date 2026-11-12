/** Usage scans and aggregation run outside the engine event loop. */
import { Worker } from 'node:worker_threads';
import type { UsageRecord } from './types.ts';
import type { UsageAggregate, UsageAggregateOptions } from './cost.ts';

export interface UsageQueryInput {
  file: string;
  pending: UsageRecord[];
  options: UsageAggregateOptions;
}

export interface UsageQueryResult {
  aggregate: UsageAggregate;
  error: string | null;
}

export function queryUsage(input: UsageQueryInput, signal: AbortSignal): Promise<UsageQueryResult> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    // The bootstrap installs its own TS loader; it must not inherit host/test preloads.
    const worker = new Worker(new URL('./usage-query-worker.mjs', import.meta.url), { workerData: input, execArgv: [] });
    const abort = () => { void worker.terminate(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: UsageQueryResult | { failure: string }) => {
      if ('failure' in message) reject(new Error(message.failure));
      else resolve(message);
    });
    worker.once('error', reject);
    worker.once('messageerror', reject);
    worker.once('exit', code => {
      signal.removeEventListener('abort', abort);
      reject(new Error(`Usage query worker exited before returning a result (${code})`));
    });
  });
}
