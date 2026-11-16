import { statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { distribution, fixtureRecord, FIXED_NOW } from './fixture.ts';
import type { UsageLog as LogType } from '../../src/core/usage-log.ts';
import type { UsageRecord } from '../../src/core/types.ts';
import type { UsageAggregateOptions } from '../../src/core/cost.ts';
import { readTextFile } from '../../src/core/util.ts';

const job = JSON.parse(readTextFile(process.argv[2])) as {
  repo: string; ledger: string; dataDir: string; scenario: string; timezone: string; now?: string;
};
const load = (file: string) => import(pathToFileURL(join(job.repo, file)).href);
const [{ UsageLog }, { aggregateUsage }, { WebApp }, { JsonlEventStore }, { nullLogger }] = await Promise.all([
  load('src/core/usage-log.ts'), load('src/core/cost.ts'), load('src/web/server.ts'), load('src/core/event-store.ts'), load('src/core/util.ts'),
]);
await mkdir(job.dataDir, { recursive: true });
const errors: string[] = [];
const log: LogType = new UsageLog(job.ledger, (e: string) => errors.push(e.replaceAll(job.ledger, '<ledger>')));
const store = new JsonlEventStore({ dataDir: job.dataDir, run: 'benchmark', log: nullLogger() });
const epoch = () => performance.timeOrigin + performance.now();
type Phase = { kind: string; id: number; start: number; end?: number; elapsedMs?: number; records?: number; memoryBefore: NodeJS.MemoryUsage; memoryAfter?: NodeJS.MemoryUsage };
let phases: Phase[] = [], active = false, last = performance.now(), gaps: number[] = [], sampledPeakRss = 0, sampledPeakHeap = 0;
let ticks = 0, events = 0, appendScheduled = false, appendAt: number | null = null, storageStarted = false;
let preloaded: UsageRecord[] | undefined;
let storageCount: number | null = null;
let nextId = 0;
const gc: { at: number; durationMs: number }[] = [];
const gcObserver = new PerformanceObserver(list => {
  if (active) for (const e of list.getEntries()) gc.push({ at: performance.timeOrigin + e.startTime, durationMs: e.duration });
});
gcObserver.observe({ entryTypes: ['gc'] });
const histogram = monitorEventLoopDelay({ resolution: 1 });
function sampleMemory() {
  const m = process.memoryUsage(); sampledPeakRss = Math.max(sampledPeakRss, m.rss); sampledPeakHeap = Math.max(sampledPeakHeap, m.heapUsed); return m;
}
function begin(kind: string, id: number): Phase {
  const p = { kind, id, start: epoch(), memoryBefore: sampleMemory() };
  if (active) phases.push(p);
  return p;
}
function end(p: Phase, records?: number) {
  p.end = epoch(); p.elapsedMs = p.end - p.start; p.records = records; p.memoryAfter = sampleMemory();
}
const timer = setInterval(() => {
  if (!active) return;
  const t = performance.now(); gaps.push(t - last); last = t; ticks++; sampleMemory();
}, 1);
const aggregate = async (opts: UsageAggregateOptions) => {
  const id = nextId++;
  const reading = begin('read', id);
  if (job.scenario === 'append' && !appendScheduled) {
    appendScheduled = true;
    setImmediate(() => { log.append({ ...fixtureRecord(999999999), recordId: 'benchmark-append' }); appendAt = epoch(); });
  }
  let records = preloaded ?? await log.readAll();
  end(reading, records.length);
  const aggregating = begin('aggregate', id);
  const report = aggregateUsage(records, { ...opts, timezone: job.timezone, now: new Date(job.now ?? FIXED_NOW) });
  end(aggregating, records.length);
  records = [];
  return report;
};
const storage = () => {
  storageStarted = true;
  const p = begin('storage-count-call', nextId++);
  const count = log.count(); storageCount = count; end(p, count ?? undefined);
  const bytes = statSync(job.ledger).size;
  return count === null ? `${bytes} bytes` : `${count} records / ${bytes} bytes`;
};
const app = new WebApp({
  store, memoryDir: job.dataDir, dataDir: job.dataDir, log: nullLogger(), host: '127.0.0.1',
  getStatus: () => {
    if (storageStarted && storageCount === null) storageCount = log.count();
    return { benchmark: true, events, ticks, count: job.scenario.startsWith('storage') ? storageCount : undefined };
  },
  usage: { aggregate, status: () => log.status() },
  storage: () => [{ owner: 'core', key: 'usage', label: 'Usage', kind: 'disk', location: 'usage.jsonl', stat: storage,
    clear: () => { throw new Error('Benchmark HTTP clear is disabled'); } }],
});
const port = await app.start(0);
if (job.scenario === 'storage-cached') {
  // Warm the same count path as the storage page, without retaining all records.
  // The pre-fix implementation has no cache and will scan again in the measured calls.
  const deadline = Date.now() + 120000;
  do {
    storageCount = log.count();
    if (storageCount !== null) break;
    if (Date.now() >= deadline) throw new Error('Storage count warmup timed out');
    await delay(25);
  } while (true);
} else if (job.scenario === 'aggregate-only') {
  preloaded = await log.readAll();
}
process.send?.({ type: 'ready', port, pid: process.pid });
process.on('message', async (message: { type: string; id?: number; sentAt?: number }) => {
  if (message.type === 'event') {
    const arrivedAt = epoch();
    const event = store.append({ ts: new Date().toISOString(), source: 'benchmark', senderKey: 'benchmark', type: 'benchmark.pulse', text: 'pulse' });
    // An event-store write and a queued handler on the host thread; no model or real World is started.
    queueMicrotask(() => { events++; process.send?.({ type: 'event-ack', id: message.id, sentAt: message.sentAt, arrivedAt, handledAt: epoch(), cursor: event.cursor }); });
  } else if (message.type === 'start') {
    phases = []; gaps = []; gc.length = 0; ticks = 0; sampledPeakRss = 0; sampledPeakHeap = 0;
    histogram.enable(); histogram.reset(); last = performance.now(); active = true; sampleMemory();
    process.send?.({ type: 'started', at: epoch(), memory: process.memoryUsage() });
  } else if (message.type === 'finish') {
    // Drain the delayed timer after a synchronous phase before sampling its longest gap.
    await delay(30);
    active = false; histogram.disable(); const endMemory = sampleMemory();
    const maxRss = process.resourceUsage().maxRSS;
    process.send?.({ type: 'result', phases, appendAt, errors,
      recordsObserved: phases.filter(p => p.kind === 'read').at(-1)?.records ?? storageCount,
      eventLoop: { timerGap: distribution(gaps), histogramMaxMs: histogram.max / 1e6, histogramP99Ms: histogram.percentile(99) / 1e6, gc },
      memory: { sampledPeakRss, sampledPeakHeap, processPeakRss: maxRss > 0 ? maxRss * 1024 : null, end: endMemory },
      boundary: 'Real WebApp routes, UsageLog, aggregateUsage and event store; synthetic event handler, no Persona/model/game. Peak RSS includes process startup and preloading.' });
  } else if (message.type === 'verify-append') {
    const records = await log.readAll();
    process.send?.({ type: 'append-result', copies: records.filter(r => r.recordId === 'benchmark-append').length, records: records.length, count: log.count() });
  } else if (message.type === 'stop') {
    clearInterval(timer); gcObserver.disconnect(); await app.stop(); process.disconnect();
  }
});
